/**
 * The threshold ruleset, shipped inside every diagnostic document so a
 * diagnostic read months later states which numbers judged it. Every ceiling
 * is provisional, derived from research runs on one machine over one link.
 *
 * Three families judge the run because one number cannot serve this pipeline:
 * absolute p95 ceilings for I/O and compute phases, a backlog ETA for queue
 * phases, and a relative share that fires only at 30% and 250 ms. A fourth,
 * steady-state family judges the interval after the run closed.
 */

import type { PhaseClass } from "./types.ts";
import type { PageErrorSource } from "../types.ts";
import { RESEND_GUARD_TICKS } from "../../pipeline/upload/delivery/resendGuard.ts";

/**
 * Bumped whenever a threshold moves or a rule is added, so two diagnostics
 * are visibly comparable or visibly not.
 */
export const RULESET_VERSION = 14;

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
 * An allowance on one absolute ceiling during a run opened by content on a
 * cold browser cache, per entity in the largest active set the run planned.
 * Every other run is held to the ceiling as written.
 */
export interface ColdOpenAllowanceRule {
  id: string;
  /** The absolute rule whose ceiling this widens. */
  widens: string;
  perEntityMs: number;
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

/**
 * Chunks the uploader stopped re-sending because the renderer kept handing
 * them back. `guardTicks` is the uploader's own bound, carried so the finding
 * prints the number that cut the loop.
 */
export interface HeldRule {
  id: string;
  minChunks: number;
  guardTicks: number;
  why: string;
}

/** The GPU lost its device or reported an error during the run. */
export interface GpuErrorRule {
  id: string;
  minErrors: number;
  why: string;
}

/**
 * Output the page raises that is known benign. An error matches when its
 * message contains `match` and, if `source` is set, it came from there.
 */
export interface AllowedError {
  source?: PageErrorSource;
  match: string;
  why: string;
}

/** The page or a worker raised an error that is not on the allow list. */
export interface PageErrorRule {
  id: string;
  minErrors: number;
  why: string;
  allow: readonly AllowedError[];
}

/** The settled frame showed one flat colour. */
export interface BlankFrameRule {
  id: string;
  why: string;
}

/** The page under the viewer scrolled, or could. */
export interface PageScrollRule {
  id: string;
  why: string;
}

/** A part of the viewer's chrome reached off the screen. */
export interface ChromeRule {
  id: string;
  /** How far past the viewport's edge a box may reach and still be inside it, in CSS pixels. */
  tolerancePx: number;
  why: string;
}

/** Planning passes woken by an availability update and nothing else. */
export interface ReplanRule {
  id: string;
  minPasses: number;
  why: string;
}

/** One ceiling on input to frame, and the reason for its number. */
export interface LagCeiling {
  ceilMs: number;
  why: string;
}

/**
 * How the view kept up with input: two ceilings on input to frame, the p95
 * for a gesture that fell behind and the max for one freeze the p95 leaves
 * out. Judged on interaction runs only. Input during a cold open waits on the
 * first frame's pipeline compile by design, which the first-paint rule
 * already reads.
 */
export interface LagRule {
  id: string;
  p95: LagCeiling & {
    /** Fewest answered inputs the p95 is judged over. */
    minInputs: number;
    minInputsWhy: string;
  };
  max: LagCeiling;
  /** Why a breach on a software fallback adapter is a note rather than a stall. */
  softwareAdapter: string;
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
  /** The plan ceiling on a cold open, widened by the size of the active set the first pass walks. */
  coldPlan: ColdOpenAllowanceRule;
  /**
   * The one ceiling an interaction run is judged by, on the frame-time
   * reading rather than a phase. `phase` names the aggregate candidate,
   * which has no per-item rows.
   */
  interaction: AbsoluteRule;
  /** A feedback loop between the uploader and the renderer, cut by the uploader's bound. */
  held: HeldRule;
  /** A lost device or a GPU error, which leaves the frame's pixels unproven. */
  gpuError: GpuErrorRule;
  /** An exception, a rejection nothing handled, or a console error, and the one list of those known benign. */
  pageError: PageErrorRule;
  /** A settled frame of one colour, read off the page's own capture. */
  blankFrame: BlankFrameRule;
  /** A page that scrolled or overflows its viewport once the run closed. */
  pageScroll: PageScrollRule;
  /** The top bar or a phone's bottom sheet not wholly on screen once the run closed. */
  chrome: ChromeRule;
  /** Input to frame on an interaction run. */
  lag: LagRule;
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
  // `decode` is the worker's own time. The wait around it, for a worker or for
  // the main thread, is a queue: on a few cores a burst of chunks waits there
  // without any decode being slow.
  "browser.decode-wait": "queue",
  "browser.decode": "compute",
  // A chunk decoded before the view wanted it, as a prefetched one is, waits
  // for the view before its upload counts. A prefetch a step ahead waits
  // there by design.
  "browser.unwanted": "queue",
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
  "server.decode-wait": "queue",
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
    why: "#899 §7: client decode round trip p50 0.09 ms, with 65% of samples under the 100 µs clock floor. Judged on the worker's own time where the worker reports it; the wait for a worker or for the main thread is browser.decode-wait, a queue.",
  },
  {
    id: "compute.upload",
    phase: "browser.upload",
    stat: "p95",
    ceilMs: 100,
    why: "#899 §7: upload dispatch was 91.6% under 100 µs. The ceiling clears the wait for a delivery tick and the per-frame upload budget with margin. Judged from when the view wanted the chunk; a chunk decoded before then waits in browser.unwanted, a queue.",
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
  coldPlan: {
    id: "compute.plan.cold-open",
    widens: "compute.plan",
    perEntityMs: 0.1,
    why: "The first plan pass of a cold open walks every entity in the active set once: the view query, chunk enumeration, admission, the member roster and the descriptor build are each linear in it. On one workstation that pass took 27 ms at 200 entities, 56 ms at 700 and 96 ms at 1,600, about 16 ms plus 50 µs per entity, so a flat ceiling fails a wide collection on a pass that is healthy for its size. On a run opened by content on a cold browser cache the plan ceiling is compute.plan's 50 ms plus 0.1 ms per entity of the largest active set the run planned: twice the measured slope, so a pass doing several times the work per entity still fails. Every other run keeps the flat ceiling, which is the one an interaction run's frame time is held to.",
  },
  interaction: {
    id: "interaction.frame-time",
    phase: "render.frame",
    stat: "p95",
    ceilMs: 50,
    why: "An interaction run is judged on whether the gesture stayed smooth, not on how much of it the main thread held: a drag ticks every frame, so its main-thread share is near total on every gesture and says nothing. The reading is main-thread tick time and includes the plan pass, so the ceiling matches compute.plan's 50 ms rather than undercutting it — three dropped frames at 60 Hz, far above a healthy tick, and a run whose planning passed cannot fail here on planning alone. It is main-thread time only: a slow GPU pass shows here only as far as it holds the main thread.",
  },
  held: {
    id: "upload.held",
    minChunks: 1,
    guardTicks: RESEND_GUARD_TICKS,
    why: "Every chunk the renderer refuses or reports lost, and every chunk its wanted set lists as missing while the page's residency mirror holds it, comes back eligible to send, so a lasting disagreement between the uploader and the renderer re-sends the same chunks every tick and the view never settles. The uploader counts ticks whose every send repeats a chunk it already sent since the last cold state. A real delivery repeats a chunk once or twice after an eviction and moves on, so that many such ticks in a row is a loop: the uploader holds those chunks until the next cold state and names each with the reason the renderer last gave. One held chunk is enough to report, because the view settled without data it asked for.",
  },
  gpuError: {
    id: "gpu.error",
    minErrors: 1,
    why: "WebGPU raises no exception for a lost device, a failed allocation, or an invalid command: the object comes back unusable and the draw that uses it does nothing. A frame drawn around one may be missing data or show none, while the pipeline's own phases look healthy. The renderer replaces a lost device and drops an atlas it could not allocate, and the page sends those chunks again, so the run carries that cost too. One error is enough to report, because a correct build reports none.",
  },
  pageError: {
    id: "page.error",
    minErrors: 1,
    why: "A page that throws while it settles can still settle: the handler that threw dropped its work, and the view settles without it. The phases cannot show that, so the error itself is the finding. One is enough, because a correct build raises none. Output known to be benign goes on the allow list below, each entry with its reason, and nowhere else.",
    allow: [],
  },
  blankFrame: {
    id: "frame.blank",
    why: "A frame of one flat colour across the whole canvas drew nothing over its background, or drew nothing at all, while every phase can look healthy. It is read off the page's own capture of its canvas, because a DevTools screenshot can leave a WebGPU canvas out. A dark view is not blank: one pixel that differs is enough, and the generated datasets draw a visible picture.",
  },
  pageScroll: {
    id: "page.scroll",
    why: "The viewer fills the visible viewport, so the page under it never scrolls. A page that can scroll gets scrolled, by the browser, a focus, or a route that kept the last page's offset, and a scrolled page carries the top bar off the screen and shows empty space below the viewer. A phone's 100vh is its height with the address bar hidden, so a rule sized in it overflows there and nowhere on a desktop. Read once the run closed: the page's scroll offset, and the document's scroll size against the viewport it scrolls in. Any offset or any overflow is enough, because a correct page has neither.",
  },
  chrome: {
    id: "page.chrome",
    tolerancePx: 0.5,
    why: "A person needs the whole top bar and a phone's whole bottom sheet on the screen: the way back, the name, search and the menu are in one, and the channels, the selectors and the panels in the other. A scrolled page carries the top bar off the top, and a shell taller than the visible viewport pushes the sheet off the bottom while a hidden overflow leaves the page itself nothing to scroll. Read once the run closed, on the full viewer page: each part's box against the viewport. Half a CSS pixel of slack absorbs layout rounding to device pixels.",
  },
  lag: {
    id: "lag.input-to-frame",
    p95: {
      minInputs: 21,
      minInputsWhy:
        "The p95 is the input at the 95th rank, which over 20 inputs or fewer is the slowest one. That input is the max ceiling's to judge, so a short gesture, a few wheel notches, is held to the max alone.",
      ceilMs: 100,
      why: "A response within 100 ms of an input reads as immediate, and past it the view is felt to trail the hand. A frame that keeps up lands two or three display intervals after its input at 60 Hz: the wait for the next frame callback, the tick and the GPU pass, and the refresh that shows it, about 50 ms. The ceiling is twice that, so a breach means the pipeline fell behind its input rather than that one frame came late. The figure stops where the GPU finishes, a refresh short of the screen, so it reads low and a breach is never the measurement's own slack.",
    },
    max: {
      ceilMs: 200,
      why: "One input that took longer than 200 ms to reach a frame is a freeze a person sees as the view stopping, however smooth the rest of the gesture was. 200 ms is where browsers grade a page's slowest input-to-paint as needing improvement. A gesture sends a few dozen inputs, so its p95 leaves out the slowest one or two, and a single long task on the main thread lands on just those; the max is judged so that the freeze is not averaged away.",
    },
    softwareAdapter:
      "A software fallback adapter rasterizes on the CPU, so its frame times measure the machine the run was on rather than the build, and on one a breach is a note.",
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
      why: "Eviction holds a tier under its budget by at most the chunk that did not fit, so a full tier reads a little under it. A tier holding nine tenths of its budget, wanting more chunks than it holds, with nothing pending and nothing in flight, has stopped asking because the rest cannot fit: it is budget-bound, and the view settles covering what it holds. That is the planned behavior under memory pressure, so the finding is a note, not a failure. Below that fill the same shortfall is something else, chunks the source could not serve yet or a queue that emptied for another reason, and is not blamed on the budget. The loss is stated in chunks of the wanted set, which is the coverage the screen goes without.",
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
