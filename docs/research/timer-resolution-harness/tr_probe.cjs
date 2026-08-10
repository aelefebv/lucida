'use strict';
// Issue #897 — standalone probe for the three things the full-app run
// (`tr_run.py`) does not cover:
//
//   1. Worker-thread clock granularity (decode and render run in workers,
//      and that is where the fine spans live).
//   2. Whether `ui.perfetto.dev` can be EMBEDDED in an iframe on a
//      cross-origin-isolated page (#887's "Open in Perfetto" recommendation).
//   3. Whether the `window.open` + `postMessage` handoff — Perfetto's own
//      documented way to receive a trace — survives `COOP: same-origin`.
//
// Serves a minimal page from a local http server, twice: once plain, once
// with COOP/COEP. Browser-level behaviour, so a minimal page is a faithful
// stand-in for the SPA (the full-app arm in `tr_run.py` covers the app).
//
//   node tr_probe.cjs [outfile.json]
const http = require('http');
const fs = require('fs');

let chromium = null;
try { ({ chromium } = require('playwright')); }
catch (e1) { try { ({ chromium } = require('@playwright/test')); }
  catch (e2) { console.log(JSON.stringify({ ok: false, reason: 'playwright_not_resolvable' })); process.exit(0); } }

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tr-probe</title></head>
<body><div id="root">probe</div></body></html>`;

function serve(headers) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const h = Object.assign({ 'content-type': 'text/html; charset=utf-8' }, headers);
      res.writeHead(200, h);
      res.end(PAGE);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

const { CLOCK_PROBE, WORKER_PROBE } = require('./tr_clock.js');

// Can a cross-origin iframe to the Perfetto UI load on this page?
const IFRAME_PROBE = `(() => new Promise((resolve) => {
  const f = document.createElement('iframe');
  f.src = 'https://ui.perfetto.dev/';
  f.style.cssText = 'width:400px;height:300px';
  let settled = false;
  const done = (r) => { if (!settled) { settled = true; resolve(r); } };
  f.onload = () => {
    // onload fires for a blocked frame too (it becomes an error page), so
    // probe the frame's own reachability rather than trusting the event.
    let contentWindowPresent = false;
    try { contentWindowPresent = !!f.contentWindow; } catch (_) {}
    done({ event: 'load', contentWindowPresent });
  };
  f.onerror = () => done({ event: 'error' });
  document.body.appendChild(f);
  setTimeout(() => done({ event: 'timeout' }), 15000);
}))()`;

// Perfetto's documented handoff is window.open + postMessage from the opener.
// COOP: same-origin puts the popup in a different browsing-context group,
// which severs window.opener — so the handshake can never complete.
const POPUP_PROBE = `(() => {
  const w = window.open('https://ui.perfetto.dev/', '_blank');
  const opened = !!w;
  let closedImmediately = null;
  try { closedImmediately = w ? w.closed : null; } catch (_) {}
  try { if (w) w.close(); } catch (_) {}
  return { opened, closedImmediately };
})()`;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  const results = {};
  for (const [arm, headers] of [
    ['baseline', {}],
    ['isolated', {
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    }],
  ]) {
    const { srv, url } = await serve(headers);
    const context = await browser.newContext();
    const page = await context.newPage();
    const failures = [];
    page.on('requestfailed', (r) => failures.push({ url: r.url().slice(0, 120), failure: (r.failure() || {}).errorText || null }));
    const openedPopups = [];
    context.on('page', (p) => openedPopups.push(p.url()));
    await page.goto(url, { waitUntil: 'load' });
    const r = { arm };
    r.main = await page.evaluate(CLOCK_PROBE);
    r.worker = await page.evaluate(WORKER_PROBE);
    r.perfetto_iframe = await page.evaluate(IFRAME_PROBE);
    // An iframe fires `load` even when COEP blocked it (it becomes an error
    // page), so the verdict comes from the network layer, not the event.
    r.perfetto_iframe_blocked = failures.some((f) => f.url.startsWith('https://ui.perfetto.dev'));
    r.perfetto_popup = await page.evaluate(POPUP_PROBE);
    await page.waitForTimeout(1500);
    r.popup_opener_severed = await (async () => {
      // Re-open and ask the POPUP whether it still sees an opener. A popup
      // in a different browsing-context group reports window.opener === null.
      // Must be CROSS-ORIGIN: an about:blank / same-origin popup inherits the
      // opener regardless of COOP, so it cannot detect the severing.
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 20000 }).catch(() => null),
        page.evaluate(() => { window.open('https://ui.perfetto.dev/', '_blank'); }),
      ]);
      if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => {});
      if (!popup) return { error: 'no_popup' };
      const v = await popup.evaluate(() => ({ hasOpener: !!window.opener })).catch((e) => ({ error: String(e).split('\n')[0] }));
      await popup.close().catch(() => {});
      return v;
    })();
    r.request_failures = failures;
    results[arm] = r;
    await context.close();
    srv.close();
  }
  await browser.close();
  // Whether ui.perfetto.dev opts in to being embedded is a fact about THEIR
  // headers. Fetched here rather than by an ad-hoc curl so it lands in the
  // committed result JSON with everything else.
  try {
    const res = await fetch('https://ui.perfetto.dev/');
    results.perfetto_headers = {
      status: res.status,
      coop: res.headers.get('cross-origin-opener-policy'),
      coep: res.headers.get('cross-origin-embedder-policy'),
      corp: res.headers.get('cross-origin-resource-policy'),
    };
  } catch (e) { results.perfetto_headers = { error: String(e).split('\n')[0] }; }
  const outfile = process.argv[2];
  const text = JSON.stringify(results, null, 2);
  if (outfile) fs.writeFileSync(outfile, text);
  console.log(text);
})();
