// PROTOTYPE — throwaway. The one renderer. Text is a *reading* of the JSON
// document, never a parallel design.
//
// The parity rule this prototype is testing: every number that appears in the
// text must exist in the JSON at a stated path, so an agent can go from a line
// of prose to the field it came from. The converse does not hold — the JSON is
// a superset and the renderer selects. `p()` records (path -> rendered string)
// for every number it prints, and selfcheck.mjs asserts that no numeric token
// in the output is unaccounted for.

import { fmtMs } from './diagnose.mjs';

export function createRenderer() {
  const provenance = [];
  return { provenance, render: (doc, depth) => renderText(doc, depth, provenance) };
}

const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v));

function renderText(doc, depth = 'summary', provenance = []) {
  const L = [];
  const p = (path, formatted) => {
    provenance.push({ path, formatted: String(formatted) });
    return formatted;
  };

  // --- verdict -------------------------------------------------------------
  const v = doc.verdict;
  L.push(`lucida trace ${doc.runId} — VERDICT: ${v.text}`);
  L.push(`confidence: ${v.confidence}`);
  L.push('');

  // --- run identity --------------------------------------------------------
  const r = doc.run;
  L.push(`dataset   ${r.dataset}  (${p('run.members', num(r.members))} member${r.members === 1 ? '' : 's'})`);
  L.push(
    `run       cause=${r.cause} · ${r.warmth} · ${p('run.wallMs', fmtMs(r.wallMs))} wall · ended: ${r.endReason}` +
      (r.target.atMs != null
        ? ` · ${r.target.event} at ${p('run.target.atMs', fmtMs(r.target.atMs))}`
        : r.target.event
          ? ` · ${r.target.event}: not reached`
          : ' · no completion event'),
  );
  // ADR 0047 makes DPR, viewport, build and GPU header fields: two runs that
  // differ on any of them are not comparable, and a header that omits one will
  // not stop anyone comparing them, only stop them noticing.
  L.push(`client    DPR ${p('run.devicePixelRatio', r.devicePixelRatio)} · ${r.viewport} · ${r.gpu} · ${r.transport} · build ${r.build}`);

  // --- coverage, always ----------------------------------------------------
  const c = doc.coverage;
  const acct =
    c.accountedPct == null
      ? 'critical path not computed'
      : `${p('coverage.accountedMs', fmtMs(c.accountedMs))} of ${p('coverage.wallMs', fmtMs(c.wallMs))} accounted (${p('coverage.accountedPct', c.accountedPct)}%)`;
  L.push(`coverage  ${acct} · server timings: ${c.serverTimings} · ${p('coverage.countedNotTimed.length', c.countedNotTimed.length)} phase counted-not-timed`);
  for (const g of c.gaps) {
    L.push(`   GAP    ${g.what}: ${g.state}${g.detail ? ` — ${g.detail}` : ''}${g.couldHideBottleneck ? '  <- could hide the bottleneck' : ''}`);
  }
  L.push('');

  // --- findings ------------------------------------------------------------
  if (!doc.findings.length) {
    L.push('FINDINGS  none — no threshold crossed.');
  } else {
    L.push(`FINDINGS (${p('findings.length', doc.findings.length)})`);
    for (const f of doc.findings.slice(0, depth === 'summary' ? 3 : doc.findings.length)) {
      L.push(`  ${f.id}  ${f.severity.toUpperCase().padEnd(9)} ${f.phase}   ${describeObserved(f, p, doc)}   [${f.rule}]  confidence: ${f.confidence}`);
      if (f.attribution) {
        L.push(`       why: ${f.attribution.why}`);
        if (f.attribution.degraded) L.push(`       degraded: ${f.attribution.degraded}`);
        if (f.attribution.runnerUp) L.push(`       also: ${f.attribution.runnerUp.label} at ${fmtMs(f.attribution.runnerUp.ms)} on the chain`);
      }
      if (f.observed.breakdown) {
        L.push(`       breakdown: ${Object.entries(f.observed.breakdown).map(([k, ms]) => `${k} ${fmtMs(ms)}`).join(' · ')}`);
      }
      if (depth !== 'summary') L.push(`       threshold: ${JSON.stringify(f.threshold.ms ?? f.threshold.minPct ?? f.threshold.backlogEtaS)} (${f.threshold.kind}) — ${f.threshold.why}`);
    }
    if (depth === 'summary' && doc.findings.length > 3) L.push(`  ... ${doc.findings.length - 3} more (see --stages)`);
  }
  L.push('');

  // --- the anti-signal, always ---------------------------------------------
  L.push(
    `NOT A HEALTH SIGNAL  ${doc.coverage.notHealthSignals.map((s) => `${s.metric}=${s.value}`).join(' · ')} — ` +
      'these paths were not exercised; absence of errors is not evidence of health.',
  );

  if (depth === 'summary') {
    L.push('');
    L.push('next');
    for (const s of doc.next) L.push(`   ${s.command.padEnd(56)} # ${s.why}`);
    return L.join('\n');
  }

  // --- depth: stages -------------------------------------------------------
  L.push('');
  L.push('CRITICAL PATH  ' + (doc.criticalPath.segments.length ? `to ${doc.criticalPath.target}` : `undefined — ${doc.criticalPath.undefinedReason}`));
  for (const s of doc.criticalPath.segments) {
    L.push(`   ${String(s.sharePct).padStart(3)}%  ${s.phase.padEnd(22)} ${fmtMs(s.ms).padStart(9)}  ${s.source}${s.key ? ` ${s.key}` : ''}`);
  }

  L.push('');
  L.push('STAGES  (totals overlap: thousands of rows run concurrently, so a total is not a share of wall clock)');
  L.push(`   ${'phase'.padEnd(22)} ${'class'.padEnd(8)} ${'n'.padStart(7)} ${'p50'.padStart(9)} ${'p95'.padStart(9)} ${'max'.padStart(9)} ${'total'.padStart(10)}  overlap`);
  for (const s of doc.stages) {
    L.push(
      `   ${s.phase.padEnd(22)} ${s.class.padEnd(8)} ${num(s.n).padStart(7)} ${fmtMs(s.p50Ms).padStart(9)} ${fmtMs(s.p95Ms).padStart(9)} ${fmtMs(s.maxMs).padStart(9)} ${fmtMs(s.totalMs).padStart(10)}  ${s.concurrencyFactor}x`,
    );
  }

  L.push('');
  L.push('LIMITERS');
  for (const l of doc.limiters) {
    L.push(`   ${l.id.padEnd(22)} cap ${String(l.cap).padStart(3)} ${l.unit.padEnd(20)} pinned ${String(l.pinnedPct).padStart(3)}% · pending p50 ${num(l.pendingP50).padStart(7)} · drain ${num(l.drainPerS)}/s · backlog ETA ${l.backlogEtaS == null ? 'n/a' : l.backlogEtaS + ' s'}`);
  }

  L.push('');
  L.push('AGGREGATE STAGES  (per-tick tier — no per-item rows by design)');
  for (const a of doc.aggregates) {
    L.push(
      `   ${a.stage.padEnd(22)} ` +
        Object.entries(a.perSecond)
          .map(([k, val]) => (k.endsWith('Us') ? `${k.slice(0, -2)} ${Math.round(val / 100) / 10} ms/s` : `${k} ${num(val)}/s`))
          .join(' · '),
    );
  }

  L.push('');
  L.push(`RAW  not inlined: ${doc.raw.why}`);
  L.push(`     ${doc.raw.export}`);
  L.push('');
  L.push('next');
  for (const s of doc.next) L.push(`   ${s.command.padEnd(56)} # ${s.why}`);
  return L.join('\n');
}

function describeObserved(f, p, doc) {
  const o = f.observed;
  const base = `findings[${f.id - 1}].observed`;
  if (o.backlogEtaS != null) {
    return `${p(base + '.pending', num(o.pending))} pending · cap ${p(base + '.inFlightCap', o.inFlightCap)} · pinned ${p(base + '.pinnedPct', o.pinnedPct)}% · drain ${p(base + '.drainPerS', num(o.drainPerS))}/s · ETA ~${p(base + '.backlogEtaS', o.backlogEtaS)} s`;
  }
  if (o.ms == null && o.pinnedPct != null) {
    return `pinned at cap ${p(base + '.inFlightCap', o.inFlightCap)} for ${p(base + '.pinnedPct', o.pinnedPct)}% of the run · pending p50 ${p(base + '.pending', num(o.pending))} · not the binding constraint in this run`;
  }
  const parts = [];
  if (o.stat) parts.push(`${o.stat} ${p(base + '.ms', fmtMs(o.ms))}`);
  else if (o.ms != null) parts.push(p(base + '.ms', fmtMs(o.ms)));
  if (o.sharePct != null) parts.push(`${p(base + '.sharePct', o.sharePct)}% of run`);
  if (o.n != null) parts.push(`n=${p(base + '.n', num(o.n))}`);
  if (o.rows === 0) parts.push('rows=0, aggregate tier');
  return parts.join(' · ');
}
