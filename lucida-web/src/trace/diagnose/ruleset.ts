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
 * Three families, because one number provably cannot serve this pipeline:
 * #899 measured p50 network first byte at 98 ms and p50 scheduler queue wait
 * at 4,600 ms, two orders of magnitude apart.
 *
 * 1. **Absolute p95 ceilings** for I/O and compute phases, each set above the
 *    worst healthy p95 observed rather than at it.
 * 2. **Backlog ETA** for queue phases, which get no per-chunk ceiling at all.
 * 3. **Relative share**, which fires only at 30% *and* 250 ms. The floor is
 *    load-bearing: without it a healthy 368 ms local open reported
 *    `STALL fetch.wire, 70% of the run`, because a fast run still spends most
 *    of itself somewhere.
 */

import type { PhaseClass } from "./types.ts";

/** Bumped whenever a threshold moves, so two diagnostics are visibly comparable or visibly not. */
export const RULESET_VERSION = 1;

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
    "Three threshold families. One number cannot serve a pipeline whose p50 network first byte is 98 ms and whose p50 scheduler queue wait is 4,600 ms (#899 §1, §3). Every ceiling is provisional, derived from throwaway-instrumented research runs on one machine and one link; the first real traces should re-derive them.",
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
};
