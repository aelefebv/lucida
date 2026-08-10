// PROTOTYPE — throwaway. The *one document*: trace bytes in, diagnostic out.
// The text renderer and the JSON output are both readings of what this returns.

import { phaseMeta } from './trace.mjs';

// ---------------------------------------------------------------------------
// The ruleset. Self-describing on purpose: it is emitted with the diagnostic so
// an agent can see which threshold fired, what it was, and where it came from.
// ---------------------------------------------------------------------------

export const RULESET = {
  version: 1,
  note:
    'Two threshold families, because a chunk\'s I/O wait and a chunk\'s queue wait ' +
    'differ by two orders of magnitude (#899 §3: p50 network first byte 98 ms, ' +
    'p50 scheduler queue wait 4,600 ms). One number cannot serve both.',
  absolute: [
    { id: 'io.ttfb', slots: ['ttfb', 'openTtfb'], stat: 'p95', ceilMs: 500,
      why: '#899 §1: worst TTFB p95 across both remote runs was 258 ms (worst single observation 354 ms over 3,781 reads); the p50-to-worst spread is under 4x.' },
    { id: 'io.body', slots: ['body', 'openBody'], stat: 'p95', ceilMs: 1000,
      why: '#899 §1: worst body p95 across both remote runs was 374 ms (p99 293-876 ms, max 1,485 ms). ' +
        'The ceiling clears the worst healthy p95 with margin; it deliberately does not clear the worst single ' +
        'observation, because one 1.5 s payload in 3,781 reads is the tail this rule is meant to catch when it becomes typical.' },
    { id: 'compute.decode', slots: ['decode'], stat: 'p95', ceilMs: 50,
      why: '#899 §7: client decode round trip p50 0.09 ms, 65% under the 100 us clock floor.' },
    { id: 'compute.upload', slots: ['upload'], stat: 'p95', ceilMs: 100,
      why: '#899 §7: upload dispatch 91.6% under 100 us.' },
    { id: 'io.wire', slots: ['wire'], stat: 'p95', ceilMs: 1500,
      why: '#899 §1: client-observed round trip p95 topped out at 1,230 ms across both remote runs. The ceiling sits above the worst healthy sample, not at it.' },
    { id: 'compute.slice', slots: ['serve'], stat: 'p95', ceilMs: 50,
      why: '#899 §7: server chunk slice/decode p50 0.6 ms.' },
  ],
  // Queue phases deliberately have NO absolute ceiling: at the measured p50 of
  // 4.6-13.6 s, any per-chunk ceiling either fires on every row or on none.
  backlog: {
    id: 'queue.backlog',
    maxEtaS: 2,
    why: '#899 §3: 20,620 requests pending against 24 in flight. Depth alone is not the signal; ' +
      'depth divided by the observed drain rate is, because it is the wait a newly planned chunk will actually see.',
  },
  occupancy: {
    id: 'limiter.pinned',
    minPinnedPct: 80,
    why: '#899 §3: both concurrency caps sat pinned at their ceiling for every interactive phase. ' +
      'A limiter pinned at cap while work waits behind it is what turns "queue wait" into a named cause.',
  },
  share: {
    id: 'share.dominant',
    minPct: 30,
    // The floor is not decoration. Without it this rule fires on every healthy
    // fast run: a 378 ms local cold open spends ~70% of itself somewhere, and
    // calling that a stall is exactly the "threshold picked in the abstract
    // fires constantly" failure the ticket warns about.
    floorMs: 250,
    why: 'A phase holding more than a third of the critical path is structural — but only once it is long enough to be worth a human second. Share without an absolute floor flags every fast run.',
  },
  prefix: {
    id: 'coverage.unrecorded-prefix',
    maxPct: 20,
    why: 'Time between run start and the first recorded row belongs to no instrument. It is reported as missing coverage, never as a stall, because nothing measured it.',
  },
  compare: {
    id: 'compare.regression',
    implemented: false, // specified only; nothing here resolves a baseline run
    minRatio: 2.0,
    why: '#899 §0: two runs of the same fixture minutes apart differed ~2x in per-request latency. ' +
      'A comparative threshold below that spread reports weather as regression.',
  },
};

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const usToMs = (us) => Math.round(us / 100) / 10;

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p50Ms: usToMs(pct(s, 0.5)),
    p95Ms: usToMs(pct(s, 0.95)),
    maxMs: usToMs(s[s.length - 1] ?? 0),
    totalMs: usToMs(s.reduce((a, b) => a + b, 0)),
  };
}

// ---------------------------------------------------------------------------
// Stage rollup
// ---------------------------------------------------------------------------

function rollup(trace) {
  const buckets = new Map();
  const push = (slot, us) => {
    if (us == null) return;
    if (!buckets.has(slot)) buckets.set(slot, []);
    buckets.get(slot).push(us);
  };
  for (const r of trace.chunks) for (const [slot, us] of Object.entries(r.durations)) push(slot, us);
  for (const r of trace.serves) for (const [slot, us] of Object.entries(r.durations)) push(slot, us);
  for (const r of trace.opens) for (const [slot, us] of Object.entries(r.durations)) push(slot, us);

  const wallUs = trace.header.wallUs || 1;
  const rows = [...buckets.entries()].map(([slot, values]) => {
    const meta = phaseMeta(slot);
    const st = stats(values);
    return {
      ...meta,
      ...st,
      // Deliberately NOT called "share of the run". Phases overlap across
      // thousands of concurrent rows, so total/wall exceeds 1 routinely; naming
      // it a share is the mistake that makes max(total) look like an answer.
      concurrencyFactor: Math.round((st.totalMs / (wallUs / 1000)) * 10) / 10,
    };
  });
  rows.sort((a, b) => b.totalMs - a.totalMs);
  return rows;
}

// ---------------------------------------------------------------------------
// Attribution
//
// Not a max(). Three mechanisms, tried in order, each with a named confidence
// and an explicit degradation when it cannot decide.
// ---------------------------------------------------------------------------

function limiterSummary(trace) {
  return trace.limiters.map((l) => {
    const pinned = l.samples.filter((s) => s.inFlight >= l.cap).length;
    const pinnedPct = Math.round((pinned / l.samples.length) * 100);
    const pendingP50 = pct([...l.samples.map((s) => s.pending)].sort((a, b) => a - b), 0.5);
    const drainPerS = Math.round(l.samples.reduce((a, s) => a + s.completions, 0) / l.samples.length);
    return {
      id: l.id,
      cap: l.cap,
      unit: l.unit,
      pinnedPct,
      pendingP50,
      drainPerS,
      backlogEtaS: drainPerS > 0 ? Math.round(pendingP50 / drainPerS) : null,
    };
  });
}

function criticalPath(trace) {
  const target = trace.header.targetUs;
  if (target == null) {
    return {
      kind: 'undefined',
      reason: trace.header.targetEvent
        ? `the run's target (${trace.header.targetEvent}) was never reached`
        : 'an interaction run has no completion event to walk a critical path back from',
    };
  }

  // Everything before the first recorded row is real time that no instrument
  // claims. It is a segment so it cannot be quietly dropped from the chain, but
  // it is marked unrecorded so nothing downstream can call it a stall.
  const segments = [];
  const firstRow = Math.min(
    ...[...trace.opens, ...trace.chunks].map((r) => r.startUs),
    trace.header.targetUs,
  );
  if (firstRow > 0) {
    segments.push({ label: 'unrecorded prefix', class: 'unrecorded', us: firstRow, source: 'derived (no rows)', rows: 0 });
  }

  // Serial prefix: nothing can be planned before dataset-open finishes.
  const openEnd = trace.opens.length
    ? Math.max(...trace.opens.map((o) => o.startUs + sum(o.durations)))
    : 0;
  if (openEnd > firstRow) {
    segments.push({
      label: 'open.read',
      class: 'io',
      us: openEnd - firstRow,
      source: 'open-table',
      rows: trace.opens.length,
      breakdown: openBreakdown(trace),
    });
  }

  // The row that finished last is the one the target waited on.
  const ended = trace.chunks
    .filter((c) => c.durations.visible)
    .map((c) => ({ c, end: c.startUs + sum(c.durations) }));
  const last = ended.sort((a, b) => b.end - a.end)[0];
  if (!last) return { kind: 'undefined', reason: 'no chunk row reaches the render phase' };

  const gap = last.c.startUs - openEnd;
  if (gap > 0) segments.push({ label: 'plan', class: 'compute', us: gap, source: 'chunk-row', rows: 1 });

  for (const [slot, us] of Object.entries(last.c.durations)) {
    if (!us) continue;
    const meta = phaseMeta(slot);
    const seg = { label: meta.label, class: meta.class, us, source: 'chunk-row', rows: 1, key: last.c.key };
    // A wire segment is a client-side bracket around server phases; if the
    // server row joined, break it down rather than reporting an opaque total.
    const serve = trace.serves.find((s) => s.corrId === last.c.corrId);
    if (slot === 'wire' && serve) seg.breakdown = Object.fromEntries(
      Object.entries(serve.durations).map(([k, v]) => [phaseMeta(k).label, usToMs(v)]),
    );
    segments.push(seg);
  }

  const chainUs = segments.reduce((a, s) => a + s.us, 0);
  return { kind: 'chain', target, chainUs, accountedPct: Math.round((chainUs / target) * 100), segments };
}

const sum = (o) => Object.values(o).reduce((a, b) => a + (b || 0), 0);

/** An open segment covers hundreds of rows; report its shape, not one number. */
function openBreakdown(trace) {
  const out = {};
  for (const slot of ['openPermit', 'openTtfb', 'openBody', 'openParse']) {
    const vals = trace.opens.map((o) => o.durations[slot]).filter((v) => v != null).sort((a, b) => a - b);
    if (vals.length) out[`${phaseMeta(slot).label} p50`] = usToMs(pct(vals, 0.5));
  }
  return out;
}

/**
 * Main-thread aggregate stages have no per-chunk rows, so they can never appear
 * on a critical path built from rows. They still steal wall clock. They are
 * offered as *candidates* with a confidence ceiling that says exactly that.
 */
function aggregateCandidates(trace) {
  const wallMs = trace.header.wallUs / 1000;
  const byStage = new Map();
  for (const a of trace.aggregates) {
    if (a.values.mainThreadUs == null) continue;
    byStage.set(a.stage, (byStage.get(a.stage) || 0) + a.values.mainThreadUs);
  }
  return [...byStage.entries()]
    .map(([stage, us]) => ({ stage, mainThreadMs: usToMs(us), sharePct: Math.round((us / 1000 / wallMs) * 100) }))
    .filter((c) => c.sharePct >= 10)
    .sort((a, b) => b.sharePct - a.sharePct);
}

function attribute(trace, path, limiters, aggCandidates, stages) {
  // 1. Saturated: the target was never reached and a limiter is pinned with a
  //    backlog. This is the case where a critical path is not merely hard to
  //    compute, it is meaningless — the run has no end to walk back from.
  const saturated = limiters.find((l) => l.pinnedPct >= RULESET.occupancy.minPinnedPct && (l.backlogEtaS ?? 0) > RULESET.backlog.maxEtaS);
  if (path.kind === 'undefined' && saturated) {
    return {
      confidence: 'resource-limited',
      cause: saturated.id,
      why: `${path.reason}; ${saturated.id} pinned at its cap of ${saturated.cap} for ${saturated.pinnedPct}% of the run with ${saturated.pendingP50.toLocaleString()} pending`,
      degraded: 'critical path not computed — no target event to walk back from',
    };
  }
  // 1b. No path and no saturation: fall back to the rollup. Percentile evidence
  //     is real evidence, it just cannot prove the phase was on anyone's
  //     critical path — hence a distinct, weaker confidence.
  if (path.kind === 'undefined') {
    // An aggregate stage eating the main thread is the expected finding for an
    // interaction run, and it outranks a percentile because it is wall clock.
    const agg = aggCandidates[0];
    if (agg && agg.sharePct >= RULESET.share.minPct && agg.mainThreadMs >= RULESET.share.floorMs) {
      return {
        confidence: 'aggregate-only',
        cause: agg.stage,
        why: `${agg.stage} held the main thread for ${fmtMs(agg.mainThreadMs)} of the run (${agg.sharePct}%), recorded as per-tick aggregates because a per-item row here is a six-figure-per-second write (#888 §4.1, count confirmed by #899 §2)`,
        degraded: `${path.reason}; with no per-item rows this stage can be shown to overlap the work, not to be on its path`,
      };
    }
    const over = stages
      .filter((s) => s.timed && s.class !== 'queue')
      .map((s) => {
        const rule = RULESET.absolute.find((r) => r.slots.includes(s.slot));
        return rule ? { s, rule, ratio: s.p95Ms / rule.ceilMs } : null;
      })
      .filter((x) => x && x.ratio > 1)
      .sort((a, b) => b.ratio - a.ratio)[0];
    if (over) {
      const opaque =
        over.s.slot === 'wire' && trace.header.serverTimings === 'absent'
          ? ' — and with no server rows the bracket cannot be split into our own permit queue and the network, which is the question this run cannot answer'
          : '';
      return {
        confidence: 'rollup-only',
        cause: over.s.label,
        why: `${over.s.label} p95 ${fmtMs(over.s.p95Ms)} over the ${fmtMs(over.rule.ceilMs)} ceiling across ${over.s.n.toLocaleString()} rows${opaque}`,
        degraded: `${path.reason} — ranked by percentile, not by position on a path`,
      };
    }
    return { confidence: 'unattributed', cause: null, why: path.reason, degraded: 'critical path not computed' };
  }

  const ranked = [...path.segments].sort((a, b) => b.us - a.us);
  const top = ranked[0];
  const second = ranked[1];
  const topAgg = aggCandidates[0];

  // 0. The chain leader is time nothing recorded. No stage can be blamed, and
  //    saying so is the whole point of keeping the segment in the chain.
  if (top.class === 'unrecorded') {
    return {
      confidence: 'partial',
      cause: null,
      why: `the largest span on the critical path (${fmtMs(usToMs(top.us))}, ${Math.round((top.us / path.target) * 100)}% of the run) is before the first recorded row`,
      degraded: 'no stage can be blamed for it — nothing instruments that stretch',
    };
  }

  // 2. An aggregate-only stage large enough to rival the chain leader. We cannot
  //    prove it was on the path, only that it held the main thread.
  if (topAgg && topAgg.sharePct >= Math.round((top.us / path.target) * 100)) {
    return {
      confidence: 'aggregate-only',
      cause: topAgg.stage,
      why: `${topAgg.stage} held the main thread for ${topAgg.mainThreadMs} ms (${topAgg.sharePct}% of the run) but has no per-item rows, so it cannot be placed on the critical path — only shown to overlap it`,
      degraded: `chain leader was ${top.label} at ${usToMs(top.us)} ms; both are reported`,
      runnerUp: { label: top.label, ms: usToMs(top.us) },
    };
  }

  // 3. A queue segment leads: name the limiter, not the queue.
  if (top.class === 'queue') {
    const l = limiters.find((x) => x.pinnedPct >= RULESET.occupancy.minPinnedPct);
    if (l) {
      return {
        confidence: 'resource-limited',
        cause: `${top.label} -> ${l.id}`,
        why: `${l.id} pinned at its cap of ${l.cap} for ${l.pinnedPct}% of the run`,
      };
    }
    return {
      confidence: 'contended',
      cause: top.label,
      why: 'the leading segment is a queue wait but no limiter was at its cap, so the constraint is upstream of anything measured here',
      degraded: 'limiter not identified',
    };
  }

  // 4. Ordinary chain leader, with a tie check.
  if (second && top.us < second.us * 1.25) {
    return {
      confidence: 'contended',
      cause: [top.label, second.label],
      why: `${usToMs(top.us)} ms vs ${usToMs(second.us)} ms — within 1.25x, so no single segment is named`,
      degraded: 'reported as a set, not a winner',
    };
  }
  const conf = path.accountedPct >= 75 ? 'attributed' : 'partial';
  return {
    confidence: conf,
    cause: top.label,
    why: `critical path back from ${trace.header.targetEvent}; ${fmtMs(usToMs(top.us))} of the ${fmtMs(usToMs(path.chainUs))} chain`,
    ...(conf === 'partial'
      ? { degraded: `the chain accounts for only ${path.accountedPct}% of the run's wall clock` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Coverage — always emitted, including when it is clean.
// ---------------------------------------------------------------------------

function coverage(trace, path) {
  const wallMs = usToMs(trace.header.wallUs);
  const recorded = path.kind === 'chain' ? path.segments.filter((s) => s.class !== 'unrecorded') : [];
  const accountedMs = path.kind === 'chain' ? usToMs(recorded.reduce((a, s) => a + s.us, 0)) : null;
  const gaps = [];

  const prefix = path.kind === 'chain' ? path.segments.find((s) => s.class === 'unrecorded') : null;
  if (prefix) {
    const sharePct = Math.round((prefix.us / path.target) * 100);
    if (sharePct >= RULESET.prefix.maxPct) {
      gaps.push({
        what: 'unrecorded prefix',
        state: `${usToMs(prefix.us)} ms (${sharePct}% of the run)`,
        detail: 'run start to the first recorded row: no instrument covers this stretch',
        couldHideBottleneck: true,
      });
    }
  }

  if (trace.header.serverTimings !== 'complete') {
    gaps.push({
      what: 'server timings',
      state: trace.header.serverTimings,
      detail: trace.header.serverTimingsNote ?? null,
      couldHideBottleneck: trace.header.serverTimings === 'absent',
    });
  }
  if (trace.header.endReason !== 'quiescent') {
    gaps.push({
      what: 'run end',
      state: trace.header.endReason,
      detail: 'the run was still producing work when recording stopped; every total below is a lower bound',
      couldHideBottleneck: true,
    });
  }
  if (trace.truncated) {
    gaps.push({ what: 'per-chunk table', state: 'truncated', detail: `stopped at row ${trace.truncated.atRow}: ${trace.truncated.reason}`, couldHideBottleneck: true });
  }
  for (const ring of trace.rings ?? []) {
    if (ring.dropped) gaps.push({ what: `${ring.name} ring`, state: 'dropped-oldest', detail: `${ring.dropped} records discarded`, couldHideBottleneck: false });
  }
  for (const s of trace.header.synthesized ?? []) {
    gaps.push({ what: 'synthesized input', state: 'prototype', detail: s, couldHideBottleneck: false });
  }

  return {
    wallMs,
    accountedMs,
    // Floor, never round: 99.6% must not print as 100% in the honesty block.
    accountedPct: accountedMs == null ? null : Math.floor((accountedMs / wallMs) * 100),
    serverTimings: trace.header.serverTimings,
    countedNotTimed: ['cache.admit'],
    countedNotTimedWhy: 'below the 100 us platform clock floor (#897); counted in the per-tick tier instead',
    structural: [
      'client-side time-to-first-byte does not exist: the transport delivers one whole frame per chunk',
      'worker CPU time is not separated from worker queue wait; decode.roundtrip is a main-thread bracket',
    ],
    gaps,
    // #899 §8: zero retries and zero evictions while 20,000 requests were behind.
    notHealthSignals: [
      { metric: 'retries', value: 0 },
      { metric: 'failures', value: 0 },
      { metric: 'evictions', value: 0 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function findings(trace, stages, limiters, path, attribution, aggCandidates) {
  const out = [];

  for (const rule of RULESET.absolute) {
    for (const slot of rule.slots) {
      const st = stages.find((s) => s.slot === slot);
      if (!st) continue;
      const v = st[rule.stat + 'Ms'];
      if (v > rule.ceilMs) {
        out.push({
          severity: 'stall',
          rule: rule.id,
          phase: st.label,
          observed: { stat: rule.stat, ms: v, n: st.n },
          threshold: { ms: rule.ceilMs, kind: 'absolute', why: rule.why },
        });
      }
    }
  }

  for (const l of limiters) {
    if ((l.backlogEtaS ?? 0) > RULESET.backlog.maxEtaS) {
      out.push({
        severity: 'saturated',
        rule: RULESET.backlog.id,
        phase: l.id,
        observed: { pending: l.pendingP50, drainPerS: l.drainPerS, backlogEtaS: l.backlogEtaS, inFlightCap: l.cap, pinnedPct: l.pinnedPct },
        threshold: { backlogEtaS: RULESET.backlog.maxEtaS, kind: 'backlog', why: RULESET.backlog.why },
      });
    } else if (l.pinnedPct >= RULESET.occupancy.minPinnedPct) {
      // Pinned but not backlogged: not the binding constraint in this run, and
      // saying so is worth a line — #899 found *two* chokepoints, and a report
      // that names only the loudest teaches the reader the other one is fine.
      out.push({
        severity: 'note',
        rule: RULESET.occupancy.id,
        phase: l.id,
        observed: { pinnedPct: l.pinnedPct, inFlightCap: l.cap, pending: l.pendingP50, drainPerS: l.drainPerS },
        threshold: { minPct: RULESET.occupancy.minPinnedPct, kind: 'occupancy', why: RULESET.occupancy.why },
      });
    }
  }

  if (path.kind === 'chain') {
    for (const seg of path.segments) {
      if (seg.class === 'unrecorded') continue; // reported as missing coverage, not as a stall
      const share = Math.round((seg.us / path.target) * 100);
      if (share >= RULESET.share.minPct && usToMs(seg.us) >= RULESET.share.floorMs) {
        out.push({
          severity: 'stall',
          rule: RULESET.share.id,
          phase: seg.label,
          observed: { ms: usToMs(seg.us), sharePct: share, rows: seg.rows, ...(seg.breakdown ? { breakdown: seg.breakdown } : {}) },
          threshold: { minPct: RULESET.share.minPct, kind: 'relative', why: RULESET.share.why },
        });
      }
    }
  }

  for (const c of aggCandidates) {
    if (c.sharePct >= RULESET.share.minPct && c.mainThreadMs >= RULESET.share.floorMs) {
      out.push({
        severity: 'stall',
        rule: RULESET.share.id,
        phase: c.stage,
        observed: { ms: c.mainThreadMs, sharePct: c.sharePct, rows: 0, tier: 'per-tick aggregate' },
        threshold: { minPct: RULESET.share.minPct, kind: 'relative', why: RULESET.share.why },
      });
    }
  }

  // Rank by how much wall clock the finding claims, and merge duplicates that
  // two rules found from different directions.
  const seen = new Set();
  const weight = (f) => (f.severity === 'note' ? 0 : 1);
  const ranked = out
    .sort(
      (a, b) =>
        weight(b) - weight(a) ||
        (b.observed.sharePct ?? 0) - (a.observed.sharePct ?? 0) ||
        (b.observed.ms ?? 0) - (a.observed.ms ?? 0),
    )
    .filter((f) => {
      const k = `${f.phase}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  return ranked.map((f, i) => ({
    id: i + 1,
    ...f,
    confidence: i === 0 ? attribution.confidence : 'observed',
    ...(i === 0 && attribution.cause ? { attribution } : {}),
  }));
}

// ---------------------------------------------------------------------------

function headline(trace, found, attribution, cov, path) {
  const caveatIf = () => (cov.gaps.some((g) => g.couldHideBottleneck) ? ' [coverage incomplete — see gaps]' : '');
  const real = found.filter((f) => f.severity !== 'note');
  if (!real.length) {
    const rec = path.kind === 'chain' ? path.segments.filter((s) => s.class !== 'unrecorded').sort((a, b) => b.us - a.us)[0] : null;
    const slowest = rec
      ? `slowest recorded segment was ${rec.label} at ${fmtMs(usToMs(rec.us))} (${Math.round((rec.us / path.target) * 100)}% of the run)`
      : 'no recorded segment to rank';
    return { kind: 'clear', text: `no stall — nothing crossed a threshold; ${slowest}${caveatIf()}` };
  }
  const f = real[0];
  const caveat = caveatIf();
  if (f.severity === 'saturated') {
    return {
      kind: 'saturated',
      text:
        `saturated — ${f.phase} held ${f.observed.pending.toLocaleString()} requests behind a cap of ` +
        `${f.observed.inFlightCap}; at the observed ${f.observed.drainPerS}/s the backlog needs ~${f.observed.backlogEtaS} s${caveat}`,
    };
  }
  const share = f.observed.sharePct != null ? ` (${f.observed.sharePct}% of the run)` : '';
  const amount = f.observed.stat ? `${f.observed.stat} ${fmtMs(f.observed.ms)}` : fmtMs(f.observed.ms);
  const verb = f.observed.stat ? 'ran' : 'held';
  return { kind: 'stall', text: `${f.phase} ${verb} ${amount}${share}${caveat}` };
}

export const fmtMs = (v) => (v == null ? '?' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`);

export function diagnose(trace) {
  const stages = rollup(trace);
  const limiters = limiterSummary(trace);
  const path = criticalPath(trace);
  const aggCandidates = aggregateCandidates(trace);
  const attribution = attribute(trace, path, limiters, aggCandidates, stages);
  const cov = coverage(trace, path);
  const fs = findings(trace, stages, limiters, path, attribution, aggCandidates);

  const doc = {
    schemaVersion: 1,
    runId: trace.header.runId,
    verdict: { ...headline(trace, fs, attribution, cov, path), confidence: attribution.confidence },
    run: {
      dataset: trace.header.dataset,
      members: trace.header.members,
      cause: trace.header.cause,
      warmth: trace.header.warmth,
      wallMs: usToMs(trace.header.wallUs),
      endReason: trace.header.endReason,
      target: { event: trace.header.targetEvent, atMs: trace.header.targetUs == null ? null : usToMs(trace.header.targetUs) },
      devicePixelRatio: trace.header.devicePixelRatio,
      viewport: trace.header.viewport,
      transport: trace.header.transport,
      build: trace.header.build,
      gpu: trace.header.gpu,
    },
    coverage: cov,
    findings: fs,
    criticalPath:
      path.kind === 'chain'
        ? { target: trace.header.targetEvent, accountedPct: path.accountedPct, segments: path.segments.map((s) => ({ phase: s.label, ms: usToMs(s.us), sharePct: Math.round((s.us / path.target) * 100), source: s.source, ...(s.key ? { key: s.key } : {}), ...(s.breakdown ? { breakdown: s.breakdown } : {}) })) }
        : { target: trace.header.targetEvent, undefinedReason: path.reason, segments: [] },
    stages: stages.map((s) => ({ phase: s.label, class: s.class, timed: s.timed, n: s.n, p50Ms: s.p50Ms, p95Ms: s.p95Ms, maxMs: s.maxMs, totalMs: s.totalMs, concurrencyFactor: s.concurrencyFactor })),
    limiters,
    aggregates: summariseAggregates(trace),
    counts: {
      chunkRows: trace.chunks.length,
      serverRows: trace.serves.length,
      openRows: trace.opens.length,
      pointEvents: trace.events.length,
    },
    raw: {
      inlined: false,
      why:
        `${trace.chunks.length.toLocaleString()} chunk rows, ${trace.serves.length.toLocaleString()} server rows, ` +
        `${trace.opens.length.toLocaleString()} open rows — raw spans are for a viewer, not a context window`,
      export: `lucida trace export ${trace.header.runId} --format chrome`,
    },
    next: nextSteps(trace, fs, attribution),
    ruleset: { version: RULESET.version, note: RULESET.note },
  };
  return doc;
}

function summariseAggregates(trace) {
  const byStage = new Map();
  for (const a of trace.aggregates) {
    const cur = byStage.get(a.stage) ?? {};
    for (const [k, v] of Object.entries(a.values)) cur[k] = (cur[k] ?? 0) + v;
    byStage.set(a.stage, cur);
  }
  const secs = Math.max(0.05, trace.header.wallUs / 1e6);
  return [...byStage.entries()].map(([stage, totals]) => ({
    stage,
    perSecond: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v / secs)])),
    totals,
  }));
}

function nextSteps(trace, found, attribution) {
  const id = trace.header.runId;
  const steps = [];
  const lead = found.find((f) => f.severity !== 'note');
  if (lead && lead.observed.rows === 0) {
    steps.push({ why: `${lead.phase} has no per-item rows; its per-tick aggregates are in the rollup`, command: `lucida trace show ${id} --stages` });
  } else if (lead) {
    const phase = typeof attribution.cause === 'string' ? attribution.cause.split(' -> ')[0] : lead.phase;
    steps.push({ why: `per-row detail for ${phase}`, command: `lucida trace show ${id} --stage ${slugify(phase)}` });
  }
  steps.push({ why: 'all phases, one row each', command: `lucida trace show ${id} --stages` });
  if (['partial', 'contended', 'unattributed', 'aggregate-only', 'rollup-only'].includes(attribution.confidence)) {
    steps.push({ why: 'the attribution is not conclusive; a second run makes the comparison possible', command: `lucida trace ${trace.header.dataset} --compare ${id}` });
  }
  steps.push({ why: 'raw spans, for a viewer rather than a context window', command: `lucida trace export ${id} --format chrome` });
  return steps;
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '.');
