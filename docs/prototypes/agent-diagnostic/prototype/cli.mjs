#!/usr/bin/env node
// PROTOTYPE — throwaway. Stands in for `lucida trace`.
//
//   node cli.mjs                                   list the scenarios
//   node cli.mjs remote-cold-open                  the default agent output
//   node cli.mjs remote-cold-open --depth stages   the rollup layer
//   node cli.mjs remote-cold-open --json           the same document as JSON
//   node cli.mjs --all                             every scenario, both formats

import { SCENARIOS } from './modules/scenarios.mjs';
import { diagnose } from './modules/diagnose.mjs';
import { createRenderer } from './modules/render.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1] ?? true;
};
const has = (name) => argv.includes(`--${name}`);

export function run(scenarioId, { depth = 'summary', json = false } = {}) {
  const s = SCENARIOS[scenarioId];
  if (!s) throw new Error(`unknown scenario: ${scenarioId}`);
  const doc = diagnose(s.build());
  if (json) return JSON.stringify(depth === 'summary' ? summaryProjection(doc) : doc, null, 2);
  return createRenderer().render(doc, depth);
}

/** The default depth is a projection of the same document, not a second one. */
export function summaryProjection(doc) {
  const { stages, aggregates, criticalPath, limiters, ...rest } = doc;
  return { ...rest, findings: doc.findings.slice(0, 3) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const positional = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--depth');
  if (has('all')) {
    for (const id of Object.keys(SCENARIOS)) {
      for (const depth of ['summary', 'stages']) {
        console.log(`\n${'='.repeat(100)}\n== ${id} — ${SCENARIOS[id].label} — depth=${depth}\n${'='.repeat(100)}\n`);
        console.log(run(id, { depth }));
      }
    }
  } else if (!positional.length) {
    console.log('scenarios:');
    for (const [id, s] of Object.entries(SCENARIOS)) console.log(`  ${id.padEnd(22)} ${s.label}`);
  } else if (argv.includes('--stage')) {
    // The samples print `--stage <phase>` in their `next` block. It is not
    // prototyped, and saying so beats a sample that instructs an agent to run a
    // command that silently does something else.
    console.log('--stage is not prototyped. Only the default and --depth stages layers exist here; see README.md.');
    process.exit(2);
  } else {
    console.log(run(positional[0], { depth: flag('depth', 'summary'), json: has('json') }));
  }
}
