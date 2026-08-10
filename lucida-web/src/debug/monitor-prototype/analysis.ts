/**
 * PROTOTYPE — throwaway. Issue #892.
 *
 * Derived readings over the lifecycle table: the per-phase rollup every
 * variant needs, and the callouts #893 will render as text. Both surfaces read
 * the same bytes, so the derivation lives here rather than inside a variant.
 */

import {
  BROWSER_PHASES,
  END_IN_FLIGHT,
  laneName,
  META_FIRST,
  META_LAST,
  NO_STAMP,
  SERVER_PHASES,
  SERVER_STAMP_COUNT,
  SOURCE_READ_CONCURRENCY,
  type BrowserPhase,
  type Trace,
} from "./traceModel.ts";

export interface PhaseRollup {
  phase: BrowserPhase;
  /** rows that completed the phase */
  n: number;
  /** rows that entered but never left — still in the phase at run end */
  openN: number;
  /** summed occupancy across rows, microseconds (concurrent, so > wall clock) */
  totalUs: number;
  p50Us: number;
  p95Us: number;
  maxUs: number;
  /** row index of the worst single occupancy */
  worstRow: number;
  /** fraction of summed chunk-time this phase holds */
  share: number;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

/**
 * @param untilUs cursor for the live view. Stamps after it have not happened
 *   yet, so a phase whose end lies beyond the cursor counts as still open —
 *   the same treatment a run that ended mid-flight gets.
 */
export function rollupPhases(trace: Trace, untilUs = Infinity): PhaseRollup[] {
  const { chunks } = trace;
  const out: PhaseRollup[] = [];
  const durations: number[][] = BROWSER_PHASES.map(() => []);
  const worst = BROWSER_PHASES.map(() => ({ us: -1, row: -1 }));
  const open = BROWSER_PHASES.map(() => 0);

  for (let r = 0; r < chunks.n; r++) {
    for (let p = 0; p < BROWSER_PHASES.length; p++) {
      const a = chunks.stamps[p * chunks.cap + r];
      const raw = chunks.stamps[(p + 1) * chunks.cap + r];
      const b = raw !== NO_STAMP && raw > untilUs ? NO_STAMP : raw;
      if (a === NO_STAMP || a > untilUs) break;
      if (b === NO_STAMP) {
        // Entered and never left. Only counts as still-open if the row was
        // actually in flight when the run ended; a retired row simply stopped
        // needing the next phase, and counting it as open would invent a stall.
        if (chunks.endReason[r] === END_IN_FLIGHT) open[p]++;
        break;
      }
      const d = b - a;
      durations[p].push(d);
      if (d > worst[p].us) {
        worst[p].us = d;
        worst[p].row = r;
      }
    }
  }

  const totals = durations.map((d) => d.reduce((a, b) => a + b, 0));
  const grand = totals.reduce((a, b) => a + b, 0) || 1;

  for (let p = 0; p < BROWSER_PHASES.length; p++) {
    const sorted = durations[p].slice().sort((a, b) => a - b);
    out.push({
      phase: BROWSER_PHASES[p],
      n: sorted.length,
      openN: open[p],
      totalUs: totals[p],
      p50Us: quantile(sorted, 0.5),
      p95Us: quantile(sorted, 0.95),
      maxUs: sorted.length ? sorted[sorted.length - 1] : 0,
      worstRow: worst[p].row,
      share: totals[p] / grand,
    });
  }
  return out;
}

export interface ServerRollup {
  phase: string;
  n: number;
  p50Us: number;
  p95Us: number;
  totalUs: number;
  share: number;
}

export function rollupServer(trace: Trace): ServerRollup[] {
  const { server } = trace;
  const buckets: number[][] = SERVER_PHASES.map(() => []);
  for (let r = 0; r < server.n; r++) {
    for (let p = 0; p < SERVER_STAMP_COUNT - 1; p++) {
      const a = server.stamps[p * server.cap + r];
      const b = server.stamps[(p + 1) * server.cap + r];
      if (a === NO_STAMP || b === NO_STAMP) break;
      buckets[p].push(b - a);
    }
  }
  const totals = buckets.map((d) => d.reduce((a, b) => a + b, 0));
  const grand = totals.reduce((a, b) => a + b, 0) || 1;
  return SERVER_PHASES.map((phase, p) => {
    const sorted = buckets[p].slice().sort((a, b) => a - b);
    return {
      phase,
      n: sorted.length,
      p50Us: quantile(sorted, 0.5),
      p95Us: quantile(sorted, 0.95),
      totalUs: totals[p],
      share: totals[p] / grand,
    };
  });
}

export function rollupMeta(trace: Trace): {
  totalUs: number;
  n: number;
  cached: boolean;
} {
  if (!trace.meta.length) return { totalUs: 0, n: 0, cached: false };
  const first = trace.meta[0].stamps[META_FIRST];
  const last = Math.max(...trace.meta.map((m) => m.stamps[META_LAST]));
  return {
    totalUs: last - first,
    n: trace.meta.length,
    cached: trace.meta.every((m) => m.hit),
  };
}

export type CalloutSeverity = "critical" | "warn" | "info";

export interface Callout {
  id: string;
  severity: CalloutSeverity;
  headline: string;
  detail: string;
  /** which phase a click should scope the timeline to, if any */
  focus?: { phase: BrowserPhase };
}

/**
 * Two stall thresholds, not one (#899): queueing is a seconds-scale problem
 * and I/O is a hundreds-of-milliseconds problem. A single threshold either
 * fires on every chunk or never fires.
 *
 * Two of these are borrowed rather than invented, from the sibling agent-surface
 * prototype on `prototype/893-agent-diagnostic-output`, so the visual and the
 * text cannot disagree about what counts as a stall:
 *
 *  - a relative share needs an ABSOLUTE FLOOR, because a fast run still spends
 *    most of itself somewhere; without one, a healthy sub-second open reports a
 *    bottleneck;
 *  - queue phases get NO absolute per-chunk ceiling. Backlog is reported as an
 *    ETA (pending / drain rate) instead, because a p50 queue wait of seconds is
 *    normal here and any fixed ceiling fires on every chunk.
 */
export const THRESHOLDS = {
  /** anything that touches the network or a device */
  ioStallUs: 500_000,
  /** a phase holding more than this share of summed chunk-time is the worst */
  dominantShare: 0.3,
  /** ...but only if it is also this long in absolute terms */
  dominantFloorUs: 250_000,
} as const;

export function formatUs(us: number): string {
  if (us >= 1e6) return `${(us / 1e6).toFixed(1)} s`;
  if (us >= 1e3) return `${Math.round(us / 1e3)} ms`;
  return `${Math.round(us)} µs`;
}

export function computeCallouts(trace: Trace): Callout[] {
  const phases = rollupPhases(trace);
  const meta = rollupMeta(trace);
  const out: Callout[] = [];

  // 1. Worst stage by share of summed chunk-time.
  const worst = phases.slice().sort((a, b) => b.totalUs - a.totalUs)[0];
  if (
    worst &&
    worst.share >= THRESHOLDS.dominantShare &&
    worst.totalUs >= THRESHOLDS.dominantFloorUs
  ) {
    out.push({
      id: "worst-stage",
      severity: "critical",
      headline: `${worst.phase} holds ${Math.round(worst.share * 100)}% of chunk-time`,
      detail:
        `${worst.n.toLocaleString()} chunks completed it, p50 ${formatUs(worst.p50Us)}, ` +
        `p95 ${formatUs(worst.p95Us)}, worst completed ${formatUs(worst.maxUs)}` +
        (worst.openN
          ? `, and ${worst.openN.toLocaleString()} never finished it. `
          : ". ") +
        (worst.phase === "queue"
          ? "This is admission throughput, not the network: rank divided by rate."
          : "Compare against the server split before blaming the network."),
      focus: { phase: worst.phase },
    });
  }

  // 2. Metadata reads — the single slowest phase of a cold remote open, and
  // invisible to every per-chunk instrument.
  if (meta.totalUs > THRESHOLDS.ioStallUs) {
    out.push({
      id: "meta-reads",
      severity: meta.totalUs > 2_000_000 ? "critical" : "warn",
      headline: `dataset-open metadata reads took ${formatUs(meta.totalUs)} before the first chunk was planned`,
      detail: `${meta.n} object reads, ${meta.cached ? "all served by the source cache" : "all source-cache misses"}. This is ahead of every chunk in the table.`,
    });
  }

  // 3. The backlog, as an ETA rather than a per-chunk ceiling, plus the worst
  // chunk named. Naming the chunk is exactly what sampling the table would cost.
  const queue = phases.find((p) => p.phase === "queue");
  if (queue && queue.openN > 0 && queue.worstRow >= 0) {
    const drainPerSec = drainRate(trace);
    const etaUs = drainPerSec > 0 ? (queue.openN / drainPerSec) * 1e6 : 0;
    out.push({
      id: "backlog",
      severity: "warn",
      headline:
        `${queue.openN.toLocaleString()} chunks never left the queue` +
        (etaUs > 0 ? ` — ${formatUs(etaUs)} more to drain at the observed rate` : ""),
      detail:
        `Worst completed wait ${formatUs(queue.maxUs)}: chunk ${trace.chunks.keys[queue.worstRow]} ` +
        `(lane ${laneName(trace.chunks, queue.worstRow)}). ` +
        `The unfinished waits are lower bounds, not measurements — the run ended before they did.`,
      focus: { phase: "queue" },
    });
  }

  // 4. In-flight pinned at the cap for the whole run — the cap is the ceiling.
  const pinned = countTicks(
    trace,
    (i) => trace.ticks.inFlight[i] >= SOURCE_READ_CONCURRENCY,
  );
  if (pinned / Math.max(1, trace.ticks.n) > 0.5) {
    out.push({
      id: "cap-pinned",
      severity: "warn",
      headline: `source-read concurrency pinned at ${SOURCE_READ_CONCURRENCY} for ${Math.round((pinned / trace.ticks.n) * 100)}% of the run`,
      detail:
        "In-flight backend reads never dropped below the process-global cap, so the observed fetch rate is our own limiter, not the object store.",
    });
  }

  // 5. Rare events: their diagnostic value is that they appear at all.
  const rare = trace.points.filter(
    (p) => p.kind === "rejection" || p.kind === "retry" || p.kind === "failure",
  );
  if (rare.length) {
    const byReason = new Map<string, number>();
    for (const p of rare) byReason.set(p.reason, (byReason.get(p.reason) ?? 0) + 1);
    out.push({
      id: "rare-events",
      severity: "info",
      headline: `${rare.length} rejection/retry events fired`,
      detail: [...byReason].map(([r, n]) => `${r} x${n}`).join(", "),
    });
  }

  // 6. Honesty. A partial picture presented as a whole one is worse than a gap.
  if (trace.header.truncated) {
    out.push({
      id: "truncated",
      severity: "critical",
      headline: "recording stopped early — this run is truncated",
      detail:
        "The per-chunk table overflowed. The beginning of the run is intact; the end is missing.",
    });
  }

  // Rank by severity. Insertion order only looked ranked because these two
  // fixtures happened to produce their worst finding first.
  const rank: Record<CalloutSeverity, number> = { critical: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Observed drain rate, chunks/s, from the slope of the queue-depth counter. */
function drainRate(trace: Trace): number {
  const { ticks } = trace;
  if (ticks.n < 2) return 0;
  let peakIdx = 0;
  for (let i = 0; i < ticks.n; i++) {
    if (ticks.queueDepth[i] > ticks.queueDepth[peakIdx]) peakIdx = i;
  }
  const last = ticks.n - 1;
  const drained = ticks.queueDepth[peakIdx] - ticks.queueDepth[last];
  const seconds = (ticks.t[last] - ticks.t[peakIdx]) / 1e6;
  return seconds > 0 ? drained / seconds : 0;
}

function countTicks(trace: Trace, pred: (i: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < trace.ticks.n; i++) if (pred(i)) n++;
  return n;
}
