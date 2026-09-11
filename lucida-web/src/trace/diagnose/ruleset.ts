/**
 * The threshold ruleset, shipped inside every diagnostic document.
 *
 * Versioned and self-describing on purpose. Every ceiling here is
 * **provisional**: they were derived from throwaway-instrumented research runs
 * (#899) on one machine over one link, and the first real traces should
 * re-derive them. A ruleset that lives in the document makes that a visible
 * change rather than a silent one — a diagnostic read six months from now
 * states which numbers judged it.
 *
 * Three families judge the run, because one number provably cannot serve this
 * pipeline: #899 measured p50 network first byte at 98 ms and p50 scheduler
 * queue wait at 4,600 ms, two orders of magnitude apart.
 *
 * 1. **Absolute p95 ceilings** for I/O and compute phases, each set above the
 *    worst healthy p95 observed rather than at it.
 * 2. **Backlog ETA** for queue phases, which get no per-chunk ceiling at all.
 * 3. **Relative share**, which fires only at 30% *and* 250 ms. The floor is
 *    load-bearing: without it a healthy 368 ms local open reported
 *    `STALL fetch.wire, 70% of the run`, because a fast run still spends most
 *    of itself somewhere.
 *
 * An interaction run adds one absolute ceiling of the first family on a
 * reading rather than a phase: main-thread frame time over the run. It
 * replaces the share rule for that reading, because a gesture ticks every
 * frame and its main-thread share is near total by construction.
 *
 * The steady-state rules are a fourth family, and they judge what the run left
 * behind rather than the run: sustained bytes received and sent, refetch of a
 * chunk already fetched, and replans woken by availability alone, all over the
 * unlabelled interval that opened when the run closed; plus a tier that cannot
 * fit what the view wants, over the run's settle block. They answer "is this
 * expected" about traffic after the view looks loaded, which no ceiling on a
 * phase can, because a settled view has no stall to find.
 *
 * One qualification sits across the families: an upload or present breach on
 * a run opened by content on a cold browser cache is first paint, not a
 * stall. Both phases run to a frame dispatch on the main thread, and the
 * frame that first draws the chunks also compiles the render pipelines. The
 * ceiling and the share rule still measure them; the first-paint rule says
 * what the breach means on a cold open, and every other run keeps the stall.
 */

import type { PhaseClass } from "./types.ts";

/**
 * Bumped whenever a threshold moves or a rule is added, so two diagnostics
 * are visibly comparable or visibly not. Version 2 added the interaction
 * frame-time ceiling. Version 3 added the steady-state family. Version 4
 * reads an upload or present breach on a cold open as a first-paint note
 * rather than a stall.
 */
export const RULESET_VERSION = 4;

export interface AbsoluteRule {
  id: string;
  /** The phase this ceiling judges. One rule, one phase: a shared ceiling hides which phase it was set for. */
  phase: string;
  stat: "p95";
  ceilMs: number;
  why: string;
}

export interface BacklogRule {
  id: string;
  maxEtaS: number;
  /** The trailing window the drain rate is measured over. */
  windowMs: number;
  why: string;
}

export interface OccupancyRule {
  id: string;
  minPinnedPct: number;
  why: string;
}

export interface ShareRule {
  id: string;
  minPct: number;
  floorMs: number;
  why: string;
}

export interface PrefixRule {
  id: string;
  maxPct: number;
  why: string;
}

export interface CompareRule {
  id: string;
  minRatio: number;
  why: string;
}

/**
 * What a breach on one of `phases` means during a run opened by content on a
 * cold browser cache: first paint rather than a stall. The ceiling and the
 * share rule still measure the phase; this rule only changes the reading of
 * a breach on such an open, and every other run is judged as before.
 */
export interface FirstPaintRule {
  id: string;
  /** The phases bounded by a main-thread frame dispatch, which the first frame's compile holds. */
  phases: readonly string[];
  why: string;
}

/**
 * A rate held for long enough to be traffic rather than a tail. For bytes
 * received, `minSeconds` counts the seconds of the interval that each carried
 * `minBytesPerS`, so a burst that finishes in two seconds does not fire. For
 * bytes sent it is the least span an interval needs before its average is
 * judged, because sends ride the planning cadence and cannot be binned.
 */
export interface SustainedRule {
  id: string;
  minBytesPerS: number;
  minSeconds: number;
  why: string;
}

/** Chunks fetched more than once inside the interval, by row identity. */
export interface RefetchRule {
  id: string;
  minChunks: number;
  why: string;
}

/**
 * A tier whose wanted set exceeds its budget: full to `minFillPct`, wanting
 * more chunks than it holds, with nothing pending and nothing in flight.
 */
export interface BudgetBoundRule {
  id: string;
  minFillPct: number;
  why: string;
}

/** Planning passes woken by an availability update and nothing else. */
export interface ReplanRule {
  id: string;
  minPasses: number;
  why: string;
}

/**
 * The five steady-state rules. Each carries its floor and its rationale, as
 * every other rule here does, so a finding prints the number that judged it
 * and the reason that number was chosen.
 */
export interface SteadyStateRules {
  received: SustainedRule;
  refetch: RefetchRule;
  budgetBound: BudgetBoundRule;
  replans: ReplanRule;
  sent: SustainedRule;
}

export interface Ruleset {
  version: number;
  note: string;
  absolute: readonly AbsoluteRule[];
  /** Queue phases, listed so their *absence* from `absolute` reads as deliberate. */
  queuePhases: readonly string[];
  backlog: BacklogRule;
  occupancy: OccupancyRule;
  share: ShareRule;
  prefix: PrefixRule;
  compare: CompareRule;
  /**
   * An upload or present breach on a run opened by content on a cold browser
   * cache, read as first paint. The only rule that reads the run's cause
   * besides the interaction ceiling, and the only one that reads its warmth.
   */
  firstPaint: FirstPaintRule;
  /**
   * The one ceiling an interaction run is judged by, on the frame-time
   * reading rather than a phase. `phase` names the aggregate candidate,
   * which has no per-item rows.
   */
  interaction: AbsoluteRule;
  /**
   * What the run left behind: four rules over the interval that opened when
   * it closed, and one over its settle block. None of them judges the run.
   */
  steadyState: SteadyStateRules;
}

/**
 * Which threshold family may judge a phase. Declared next to the phase
 * inventory rather than inferred from a name, so adding a phase forces the
 * decision instead of defaulting to one.
 */
export const PHASE_CLASSES: Record<string, PhaseClass> = {
  "browser.plan": "compute",
  "browser.queue": "queue",
  "browser.wire": "io",
  "browser.decode": "compute",
  "browser.upload": "compute",
  "browser.present": "compute",
  "server.arrival": "compute",
  // A lock wait, not free time: binding lookup takes the shared session mutex,
  // so every chunk request from every client in the workspace serialises there.
  "server.binding-lookup": "queue",
  "server.dispatch": "compute",
  "server.cache-lookup": "compute",
  "server.permit-wait": "queue",
  "server.backend-read": "io",
  "server.coalesced-wait": "queue",
  "server.decompress": "compute",
  "server.slice-encode": "compute",
  "server.handoff": "compute",
  // The open bracket rather than a recorded phase: the reads nest inside it,
  // and it is classed as I/O because that is what it spends itself on. No
  // absolute ceiling — an open's length is a property of the dataset, not of
  // the pipeline's health.
  "metadata.dataset-open": "io",
  "metadata.cache-hit": "compute",
  "metadata.coalesced-wait": "queue",
  "metadata.backend-read": "io",
};

const ABSOLUTE: readonly AbsoluteRule[] = [
  {
    id: "io.wire",
    phase: "browser.wire",
    stat: "p95",
    ceilMs: 1_500,
    why: "#899 §1: client-observed round trip p95 topped out at 1,230 ms across both remote runs. The ceiling sits above the worst healthy sample, not at it.",
  },
  {
    id: "compute.plan",
    phase: "browser.plan",
    stat: "p95",
    ceilMs: 50,
    why: "A plan pass is main-thread work between frames; healthy passes are sub-millisecond. 50 ms is three dropped frames at 60 Hz — far above healthy, low enough to catch the re-scan class of defect (#870).",
  },
  {
    id: "compute.decode",
    phase: "browser.decode",
    stat: "p95",
    ceilMs: 50,
    why: "#899 §7: client decode round trip p50 0.09 ms, with 65% of samples under the 100 µs clock floor.",
  },
  {
    id: "compute.upload",
    phase: "browser.upload",
    stat: "p95",
    ceilMs: 100,
    why: "#899 §7: upload dispatch was 91.6% under 100 µs. The ceiling clears the wait for a delivery tick and the per-frame upload budget with margin.",
  },
  {
    id: "compute.present",
    phase: "browser.present",
    stat: "p95",
    ceilMs: 100,
    why: "Present is bounded by the following frame's dispatch, so a healthy p95 is one frame interval. 100 ms clears six dropped frames at 60 Hz.",
  },
  {
    id: "server.arrival",
    phase: "server.arrival",
    stat: "p95",
    ceilMs: 10,
    why: "Frame off the socket to request recognised is parsing only. Rust's Instant has no platform floor, so a healthy p95 here is microseconds; 10 ms is three orders above it.",
  },
  {
    id: "server.dispatch",
    phase: "server.dispatch",
    stat: "p95",
    ceilMs: 10,
    why: "Binding in hand to the serve task doing work. Bookkeeping only; the waits it used to hide are their own phases now (#930).",
  },
  {
    id: "server.cache-lookup",
    phase: "server.cache-lookup",
    stat: "p95",
    ceilMs: 10,
    why: "An LRU probe and a single-flight election. #902 measured a fully warm repeat open at 0.02 s across every read it made.",
  },
  {
    id: "server.backend-read",
    phase: "server.backend-read",
    stat: "p95",
    ceilMs: 1_000,
    why: "#899 §1: worst body p95 across both remote runs was 374 ms (p99 293–876 ms, max 1,485 ms). The ceiling clears the worst healthy p95 with margin and deliberately does not clear the worst single observation — one 1.5 s payload in 3,781 reads is the tail this rule exists to catch when it becomes typical.",
  },
  {
    id: "server.decompress",
    phase: "server.decompress",
    stat: "p95",
    ceilMs: 50,
    why: "#899 §7: server chunk slice and decode p50 0.6 ms.",
  },
  {
    id: "server.slice-encode",
    phase: "server.slice-encode",
    stat: "p95",
    ceilMs: 50,
    why: "Same measurement as decompress: #899 §7 put the pair at p50 0.6 ms together.",
  },
  {
    id: "server.handoff",
    phase: "server.handoff",
    stat: "p95",
    ceilMs: 10,
    why: "A push onto the outbound queue. Socket write time is deliberately not in this phase, so anything here is bookkeeping.",
  },
  {
    id: "metadata.cache-hit",
    phase: "metadata.cache-hit",
    stat: "p95",
    ceilMs: 10,
    why: "A source-cache hit returns bytes already held. #902 measured the whole warm open at 0.02 s across hundreds of these.",
  },
  {
    id: "metadata.backend-read",
    phase: "metadata.backend-read",
    stat: "p95",
    ceilMs: 1_000,
    why: "The same round trip a chunk's backend read makes, against the same link, so it carries the same ceiling. #893 found these reads are 91% of a cold headline run, which is why they are judged rather than merely counted.",
  },
];

export const RULESET: Ruleset = {
  version: RULESET_VERSION,
  note:
    "Three threshold families over the run, and a fourth over the interval after it closed. One number cannot serve a pipeline whose p50 network first byte is 98 ms and whose p50 scheduler queue wait is 4,600 ms (#899 §1, §3). Every ceiling is provisional, derived from throwaway-instrumented research runs on one machine and one link; the first real traces should re-derive them.",
  absolute: ABSOLUTE,
  queuePhases: Object.entries(PHASE_CLASSES)
    .filter(([, cls]) => cls === "queue")
    .map(([id]) => id),
  backlog: {
    id: "queue.backlog",
    maxEtaS: 2,
    windowMs: 1_000,
    why: "#899 §3: 20,620 requests pending against 24 in flight. Depth alone is not the signal — depth divided by the observed drain rate is, because that is the wait a newly planned chunk will actually see. The window is the trailing second: it matches the rolling-window convention upload telemetry already uses, and it is short enough to track a limiter that changes behaviour mid-run.",
  },
  occupancy: {
    id: "limiter.pinned",
    minPinnedPct: 80,
    why: "#899 §3: both concurrency caps sat pinned at their ceiling for every interactive phase. A limiter pinned at cap while work waits behind it is what turns an anonymous queue wait into a named cause.",
  },
  share: {
    id: "share.dominant",
    minPct: 30,
    floorMs: 250,
    why: "A segment holding more than a third of the critical path is structural — but only once it is long enough to be worth a human second. Share without an absolute floor flags every fast run: a healthy 368 ms local open reported STALL fetch.wire, 70% of the run, because a fast run still spends most of itself somewhere (#893).",
  },
  prefix: {
    id: "coverage.unrecorded-prefix",
    maxPct: 20,
    why: "Time between run start and the first recorded boundary belongs to no instrument. It is reported as missing coverage and never as a stall, because nothing measured it — and #893 found it was 87% of a healthy local cold open.",
  },
  compare: {
    id: "compare.regression",
    minRatio: 2,
    why: "#899 §0: two runs of the same fixture minutes apart differed about 2x in per-request latency. A comparative threshold below that spread reports weather as regression.",
  },
  firstPaint: {
    id: "frame.first-paint",
    phases: ["browser.upload", "browser.present"],
    why: "Upload and present each run to a frame dispatch on the main thread, and on a cold open the frame after the first chunks land is the first frame that draws them. The render worker compiles its pipelines inside that frame, which held the GPU process for 150 to 200 ms in slice mode and about 750 ms in volume mode on a hardware adapter (#1094), and the page's frames wait behind it. The chunks were not slow; the first paint was. So an upload or present breach on a run opened by content on a cold browser cache is a note that names the cost, never a stall. A dataset added to a live page opens a content run too, but its caches hold chunks and its pipelines are compiled, so it keeps the stall. An interaction run once the page is quiescent draws through pipelines already compiled, keeps the stall, and is what confirms a regression.",
  },
  interaction: {
    id: "interaction.frame-time",
    phase: "render.frame",
    stat: "p95",
    ceilMs: 50,
    why: "An interaction run is judged on whether the gesture stayed smooth, not on how much of it the main thread held: a drag ticks every frame, so its main-thread share is near total on every gesture and says nothing. The reading is main-thread tick time and includes the plan pass, so the ceiling matches compute.plan's 50 ms rather than undercutting it — three dropped frames at 60 Hz, far above a healthy tick, and a run whose planning passed cannot fail here on planning alone. It is main-thread time only: a slow GPU pass shows here only as far as it holds the main thread.",
  },
  steadyState: {
    received: {
      id: "steady.received",
      minBytesPerS: 32 * 1024,
      minSeconds: 5,
      why: "After the view settles the pipeline owes it nothing: prefetch and minimap seeding are finite and finish within a few seconds, and a settled view fetches nothing. 32 KiB/s is a tenth of one remote chunk a second at the 326 KiB per chunk the remote-rates research measured, so a second that carries it is a second the pipeline was still fetching. Five such seconds after settle is traffic rather than a tail. Seconds are counted one by one so a burst that finishes in two does not fire, and bytes are counted once per wire request so rows that coalesced onto one fetch do not multiply it. Provisional, like every floor here.",
    },
    refetch: {
      id: "steady.refetch",
      minChunks: 4,
      why: "A chunk fetched twice in one interval with the view unchanged was evicted and wanted again. One or two are boundary cases: a speculative chunk dropped and re-requested, a level crossing under the view. A loop under budget pressure evicts in batches and so refetches many chunks at once. Four is above the boundary cases on a small view and well under the smallest loop, which cycles the whole wanted set. The window is the interval, and it is printed with the count because a count without a denominator is not a measurement.",
    },
    budgetBound: {
      id: "steady.budget-bound",
      minFillPct: 90,
      why: "Eviction holds a tier under its budget by at most the chunk that did not fit, so a full tier reads a little under it. A tier holding nine tenths of its budget, wanting more chunks than it holds, with nothing pending and nothing in flight, has stopped asking because the rest cannot fit: it is budget-bound, and a run waiting on it cannot settle. Below that fill the same shortfall is something else, chunks the source could not serve yet or a queue that emptied for another reason, and is not blamed on the budget. The loss is stated in chunks of the wanted set, which is the coverage the screen goes without, rather than as the timeout it causes.",
    },
    replans: {
      id: "steady.replans",
      minPasses: 3,
      why: "The server announces generated coarse chunks as they become ready, and a view whose coarse tier was waiting re-plans once to pick them up. A pass woken by nothing but such an update, three times in one interval with no input between, is the client and the server taking turns: each plan asks, each answer wakes another plan. The count is how many turns, so the loop is visible as one finding rather than as a rising row count.",
    },
    sent: {
      id: "steady.sent",
      minBytesPerS: 1024,
      minSeconds: 5,
      why: "Presence once a second and a pointer's cursor messages come to a few hundred bytes a second, which is the page's heartbeat. A kilobyte a second held over five seconds or more after the view settled is the socket not going quiet, and the type it is attributed to says what kept it open. An average over the interval rather than a count of busy seconds, because sends ride the planning cadence and cannot be binned by the second; the span is printed beside the rate.",
    },
  },
};
