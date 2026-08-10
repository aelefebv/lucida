#!/usr/bin/env node
// PROTOTYPE — throwaway. Not a test suite; a set of assertions that the claims
// the write-up makes about this prototype are actually true of it.
//
//   node selfcheck.mjs

import { SCENARIOS } from './modules/scenarios.mjs';
import { diagnose, fmtMs, RULESET } from './modules/diagnose.mjs';
import { ALL_PHASES } from './modules/trace.mjs';
import { createRenderer } from './modules/render.mjs';

let failures = 0;
const check = (name, fn) => {
  try {
    const problem = fn();
    if (problem) {
      failures++;
      console.log(`FAIL  ${name}\n      ${problem}`);
    } else {
      console.log(`ok    ${name}`);
    }
  } catch (e) {
    failures++;
    console.log(`ERROR ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`);
  }
};

const docs = Object.fromEntries(Object.entries(SCENARIOS).map(([id, s]) => [id, diagnose(s.build())]));
const rendered = Object.fromEntries(
  Object.entries(docs).map(([id, doc]) => {
    const r = createRenderer();
    const summary = r.render(doc, 'summary');
    return [id, { summary, provenance: r.provenance, stages: createRenderer().render(doc, 'stages') }];
  }),
);

// ---------------------------------------------------------------------------
// Parity: the text is a reading of the JSON, so no number may be invented by
// the renderer. Prose lines (rule rationale, gap detail, commands, identifiers)
// are exempt — they quote the research notes, not this run.
// ---------------------------------------------------------------------------

const EXEMPT = /^(client |   GAP|       why:|       degraded:|       threshold:|       also:|NOT A HEALTH|   lucida|dataset )/;

function jsonNumberTokens(doc) {
  const out = new Set();
  const add = (n) => {
    if (typeof n !== 'number' || !isFinite(n)) return;
    for (const s of [String(n), n.toLocaleString('en-US'), fmtMs(n), String(Math.round(n))]) {
      for (const tok of String(s).match(/[0-9][0-9,]*(\.[0-9]+)?/g) ?? []) out.add(tok);
    }
  };
  const walk = (v) => {
    if (typeof v === 'number') add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(doc);
  return out;
}

for (const [id, doc] of Object.entries(docs)) {
  check(`${id}: every number in the default text exists in the document`, () => {
    const allowed = jsonNumberTokens(doc);
    const bad = [];
    for (const line of rendered[id].summary.split('\n')) {
      if (EXEMPT.test(line)) continue;
      // Strip run ids and percentile labels: they are identifiers, not readings.
      const scrubbed = line.replace(/\br-[0-9a-z]+\b/g, '').replace(/\bp\d{2}\b/g, '');
      for (const raw of scrubbed.match(/[0-9][0-9,]*(\.[0-9]+)?/g) ?? []) {
        const tok = raw.replace(/,+$/, '');
        if (!allowed.has(tok)) bad.push(`${tok}  (line: ${line.trim().slice(0, 70)})`);
      }
    }
    return bad.length ? `renderer produced numbers not present in the JSON:\n      ${bad.join('\n      ')}` : null;
  });

  check(`${id}: every recorded provenance path resolves in the document`, () => {
    const bad = [];
    for (const { path } of rendered[id].provenance) {
      const v = path.split('.').reduce((acc, part) => {
        if (acc == null) return undefined;
        const m = part.match(/^(\w+)\[(\d+)\]$/);
        return m ? acc[m[1]]?.[Number(m[2])] : acc[part];
      }, doc);
      if (v === undefined) bad.push(path);
    }
    return bad.length ? `unresolvable: ${[...new Set(bad)].join(', ')}` : null;
  });
}

// ---------------------------------------------------------------------------
// Budget: the default output has to fit an agent's context without thought.
// ---------------------------------------------------------------------------

for (const [id, r] of Object.entries(rendered)) {
  check(`${id}: default output stays under the 3 kB / 30 line budget`, () => {
    const lines = r.summary.split('\n').length;
    const bytes = Buffer.byteLength(r.summary);
    return bytes > 3000 || lines > 30 ? `${bytes} bytes / ${lines} lines` : null;
  });
}

// ---------------------------------------------------------------------------
// Threshold behaviour
// ---------------------------------------------------------------------------

check('a fast healthy run fires nothing', () => {
  const d = docs['local-cold-open'];
  const real = d.findings.filter((f) => f.severity !== 'note');
  return real.length ? `fired: ${real.map((f) => `${f.phase}/${f.rule}`).join(', ')}` : null;
});

check('the share rule needs an absolute floor, not just a percentage', () => {
  // Without the floor, the 32 ms fetch.wire segment of the healthy run holds
  // enough of that run's critical path to be called a stall.
  const d = docs['local-cold-open'];
  const seg = d.criticalPath.segments.find((s) => s.phase === 'fetch.wire');
  if (!seg) return 'expected a fetch.wire segment on the healthy run';
  return seg.ms >= 250 ? `the healthy run's leader is ${seg.ms} ms — pick a different example` : null;
});

check('unrecorded time is never reported as a stall', () => {
  for (const [id, d] of Object.entries(docs)) {
    if (d.findings.some((f) => f.phase === 'unrecorded prefix')) return `${id} blamed the unrecorded prefix`;
  }
  return null;
});

check('unrecorded time is reported as a coverage gap instead', () => {
  const d = docs['local-cold-open'];
  return d.coverage.gaps.some((g) => g.what === 'unrecorded prefix') ? null : 'no gap raised for the 298 ms prefix';
});

check('no queue phase carries an absolute per-chunk ceiling', () => {
  const queueSlots = new Set(ALL_PHASES.filter(([, , cls]) => cls === 'queue').map(([slot]) => slot));
  const offenders = RULESET.absolute.filter((r) => r.slots.some((s) => queueSlots.has(s)));
  return offenders.length ? `queue slots given an absolute ceiling: ${offenders.map((r) => r.id).join(', ')}` : null;
});

// ---------------------------------------------------------------------------
// Attribution behaviour
// ---------------------------------------------------------------------------

check('cold remote open blames dataset-open reads, with a path', () => {
  const d = docs['remote-cold-open'];
  const f = d.findings[0];
  if (f.phase !== 'open.read') return `blamed ${f.phase}`;
  if (d.verdict.confidence !== 'attributed') return `confidence was ${d.verdict.confidence}`;
  return d.criticalPath.segments.length ? null : 'no critical path was produced';
});

check('attribution is not a max() over stage totals', () => {
  const d = docs['remote-cold-open'];
  const biggestTotal = [...d.stages].sort((a, b) => b.totalMs - a.totalMs)[0];
  // open.ttfb has the largest summed total (41.6 s across 200 concurrent rows)
  // but the blamed segment is the serial open span, not that sum.
  return biggestTotal.phase === d.findings[0].phase
    ? `the blamed phase happens to equal max(total) — this scenario no longer proves the point`
    : null;
});

check('saturation degrades to a limiter, and says the path is undefined', () => {
  const d = docs['remote-warm-reopen'];
  if (d.verdict.kind !== 'saturated') return `verdict kind was ${d.verdict.kind}`;
  if (d.verdict.confidence !== 'resource-limited') return `confidence was ${d.verdict.confidence}`;
  if (d.criticalPath.segments.length) return 'a critical path was computed for a run with no target';
  return d.findings[0].attribution?.degraded ? null : 'no degradation was stated';
});

check('an interaction run falls back to percentiles and says so', () => {
  const d = docs['interaction-orbit'];
  if (d.verdict.confidence !== 'rollup-only') return `confidence was ${d.verdict.confidence}`;
  return /cannot be split/.test(d.findings[0].attribution?.why ?? '')
    ? null
    : 'the missing server rows were not named as the reason attribution stops';
});

check('a second chokepoint is still reported when it is not the binding one', () => {
  const d = docs['remote-cold-open'];
  return d.findings.some((f) => f.severity === 'note' && f.phase === 'server.source_read')
    ? null
    : 'the pinned 12-permit limiter went unmentioned';
});

// ---------------------------------------------------------------------------
// Honesty
// ---------------------------------------------------------------------------

check('coverage is emitted on every run, including the clean one', () => {
  for (const [id, d] of Object.entries(docs)) {
    if (!d.coverage || d.coverage.wallMs == null) return `${id} has no coverage block`;
    if (!d.coverage.structural?.length) return `${id} omits the structural limits`;
  }
  return null;
});

check('a run with a bottleneck-hiding gap carries the caveat in its verdict', () => {
  for (const [id, d] of Object.entries(docs)) {
    const hides = d.coverage.gaps.some((g) => g.couldHideBottleneck);
    const carries = /coverage incomplete/.test(d.verdict.text);
    if (hides !== carries) return `${id}: gap=${hides} but verdict caveat=${carries}`;
  }
  return null;
});

check('zero-error counters are never presented as health', () => {
  for (const [id, r] of Object.entries(rendered)) {
    if (!/NOT A HEALTH SIGNAL/.test(r.summary)) return `${id} omits the anti-signal line`;
  }
  return null;
});

check('raw rows are never inlined into the agent output', () => {
  for (const [id, d] of Object.entries(docs)) {
    if (d.raw.inlined) return `${id} inlines raw rows`;
    if (JSON.stringify(d).includes('"durations"')) return `${id} leaked lifecycle rows into the document`;
  }
  return null;
});

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
