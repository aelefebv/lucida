#!/usr/bin/env node
// PROTOTYPE — throwaway. Bakes the samples into one double-clickable file, so
// the output can be read side by side without a toolchain.
//
//   node build-html.mjs   ->  ../samples.html

import { writeFileSync } from 'node:fs';
import { SCENARIOS } from './modules/scenarios.mjs';
import { diagnose } from './modules/diagnose.mjs';
import { createRenderer } from './modules/render.mjs';
import { summaryProjection } from './cli.mjs';

const data = {};
for (const [id, s] of Object.entries(SCENARIOS)) {
  const doc = diagnose(s.build());
  data[id] = {
    label: s.label,
    summary: { text: createRenderer().render(doc, 'summary'), json: JSON.stringify(summaryProjection(doc), null, 2) },
    stages: { text: createRenderer().render(doc, 'stages'), json: JSON.stringify(doc, null, 2) },
  };
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>PROTOTYPE — agent-facing diagnostic output (lucida #893)</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; max-width: 1200px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; opacity: .7; }
  .bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; align-items: center; }
  .bar b { font-weight: 600; width: 78px; font-size: 12px; opacity: .6; text-transform: uppercase; letter-spacing: .04em; }
  button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid currentColor; background: transparent; cursor: pointer; opacity: .55; }
  button[aria-pressed="true"] { opacity: 1; font-weight: 600; }
  pre { background: rgba(127,127,127,.12); padding: 16px; border-radius: 8px; overflow-x: auto;
        font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
  .meta { opacity: .6; font-size: 12px; margin: 12px 0 4px; }
</style>
<h1>PROTOTYPE — what an agent reads from a lucida run</h1>
<p class="sub">Throwaway sample output for <a href="https://github.com/aelefebv/lucida/issues/893">issue #893</a>.
Runs are synthesized from the measured distributions in #888 and #899 — see the prototype README for what is measured and what is not.</p>

<div class="bar"><b>run</b><span id="scenarios"></span></div>
<div class="bar"><b>depth</b><span id="depths"></span></div>
<div class="bar"><b>format</b><span id="formats"></span></div>
<p class="meta" id="meta"></p>
<pre id="out"></pre>

<script>
const DATA = ${JSON.stringify(data)};
let scenario = Object.keys(DATA)[0], depth = 'summary', format = 'text';
const group = (el, items, get, set) => {
  el.innerHTML = '';
  for (const [value, label] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { set(value); draw(); };
    b.setAttribute('aria-pressed', String(get() === value));
    el.append(b);
  }
};
function draw() {
  group(scenarios, Object.entries(DATA).map(([id, d]) => [id, d.label]), () => scenario, v => scenario = v);
  group(depths, [['summary', 'default (what an agent gets)'], ['stages', 'per-stage rollup']], () => depth, v => depth = v);
  group(formats, [['text', 'text'], ['json', 'JSON']], () => format, v => format = v);
  const body = DATA[scenario][depth][format];
  out.textContent = body;
  meta.textContent = body.length.toLocaleString() + ' bytes · ' + body.split('\\n').length + ' lines';
}
draw();
</script>
`;

const dest = new URL('../samples.html', import.meta.url);
writeFileSync(dest, html);
console.log(`wrote ${dest.pathname} (${Math.round(html.length / 1024)} kB)`);
